/* global jest */

const React = require('react');
const { View } = require('react-native');

module.exports = {
  Camera: props => React.createElement(View, props),
  useCameraDevice: () => ({ id: 'mock-camera' }),
  useCameraPermission: () => ({
    hasPermission: false,
    requestPermission: jest.fn(async () => true),
  }),
  useCodeScanner: options => options,
};
